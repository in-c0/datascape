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
import { createAuthorityJournal, createMemoryStorage } from "../src/continuity/control/authority-journal.js";
import {
  createCommitJournalPort, createJournalExceptionPort,
} from "../src/continuity/control/authority-exception-port.js";
import { revisionOf } from "../src/continuity/control/authority-operation.js";

const SESSION = "session-S1";

function harness({ outcome = "verified", revision = 1, baseRevision = undefined, applyResult = null, storage: seeded = null } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const state = { revision, session: SESSION, consumeOk: true };
  const prompts = [];
  const writes = [];
  // THE REAL JOURNAL, not a Map. The parts 0-8 review's point was precisely
  // that a second in-process durable truth is not durable and not a truth: it
  // could not see a restart, could not detect a same-id-different-receipt
  // attempt, and let two concurrent requests both prompt. Testing against a
  // stand-in would have kept all three defects invisible.
  const storage = seeded ?? createMemoryStorage();

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
    baseRevision: baseRevision === undefined ? revision : baseRevision,
    resultingScopeRefs: ["scope:datascape/briefing"],
    readSessionId: SESSION,
  });

  const issued = new Set();

  // A minimal exception store with the ADAPTER's contract, reached only through
  // the translating port — so these tests exercise the same translation the
  // host uses rather than a convenient shortcut past it.
  const blockers = new Map([[
    "2026-08-21-datascape-v6-execution-authority-b4e2",
    { status: "blocked-on-owner", refs: [] },
  ]]);
  const adapter = {
    resolve(id, rulingRef) {
      const item = blockers.get(id);
      if (!item) return { ok: false, failure: "unknown_exception", reason: `no exception ${id}` };
      const others = item.refs.filter((r) => r !== rulingRef);
      if (others.length) {
        return { ok: false, failure: "already_authorized", existing_refs: others,
          reason: `already resolved by ${others.join(", ")}` };
      }
      if (item.refs.includes(rulingRef) && item.status === "resolved") {
        return { ok: true, replayed: true, status: "resolved", ruling_ref: rulingRef };
      }
      item.refs.push(rulingRef);
      item.status = "resolved";
      return { ok: true, replayed: false, status: "resolved", ruling_ref: rulingRef, at: now() };
    },
    isResolved: (id) => blockers.get(id)?.status === "resolved",
  };

  const journal = createAuthorityJournal({
    storage, now, exceptions: createJournalExceptionPort(adapter),
  });
  const state_ = state;
  const operations = createCommitJournalPort({
    journal, revisionOf, now,
    currentRevision: () => {
      // `duringCommit` moves the world exactly once, at the moment the
      // transaction reads the revision — which is the only window the final CAS
      // exists to cover.
      if (state_.duringCommit) { const f = state_.duringCommit; state_.duringCommit = null; f(); }
      return state_.revision;
    },
    applyAuthority: (r) => {
      if (applyResult) return applyResult;
      writes.push(r);
      return { ok: true, value: { authority_id: "auth:1", action: r.action, revision: (state_.revision ?? 0) + 1, ruling: { ref: `ruling:${r.receipt_id}` }, source_exception_id: r.source_exception_id } };
    },
  });

  const deps = {
    now,
    authenticate: () => (state.session
      ? { ok: true, context: { principal: "owner", read_session_id: state.session, expires_at: clock + 1000 } }
      : { ok: false, failure: "read_session_invalid", reason: "the owner-read session has expired or was replaced" }),
    operations,
    receipts,
    presence: {
      verifier: {
        verify: async ({ purpose, operationRef }) => {
          prompts.push({ purpose, operationRef });
          if (state.stallAfterClaim) throw new Error("the host died while the dialog was open");
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
  };

  return {
    deps, receipt, state, prompts, writes, journal, storage, blockers, issued,
    /** A SECOND prepared review, for same-id-different-receipt. */
    issue: (over = {}) => receipts.issue({
      draft: createAuthorityDraft({
        draft_id: "draft:other", kind: "bounded_canary",
        statement: over.statement || "another bounded task",
        scope_refs: ["scope:datascape/authority"], allowed_capabilities: ["read"],
        stop_conditions: ["reviewed"], max_cost: 0,
      }),
      action: "authorize_bounded_task",
      sourceExceptionId: "2026-08-21-datascape-v6-execution-authority-b4e2",
      goalId: "goal:1",
      baseRevision: baseRevision === undefined ? revision : baseRevision,
      resultingScopeRefs: ["scope:datascape/authority"],
      readSessionId: SESSION,
    }),
    /** A NEW journal over the SAME storage: what a restart actually is. */
    restart: () => harness({ outcome, revision, baseRevision, applyResult, storage }),
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

test("wire: an unknown field is refused, and an operation id is always required", () => {
  assert.equal(validateCommitWire({ operation_id: "op", preview_receipt: "r", note: "hi" }).failure, "unknown_commit_field");
  assert.equal(validateCommitWire({ preview_receipt: "r" }).failure, "invalid_commit");
  assert.equal(validateCommitWire({ operation_id: "op", preview_receipt: 7 }).failure, "invalid_commit");
  assert.equal(validateCommitWire({ operation_id: "op", preview_receipt: "r" }).ok, true);
});

test("wire: an operation id ALONE is a replay request, not a commit", () => {
  // The old wire required both, which made the documented recovery story
  // unreachable: after a restart the receipt store is gone, so the id she would
  // have to supply no longer exists anywhere.
  const replay = validateCommitWire({ operation_id: "op" });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay_only, true);
  assert.equal(replay.preview_receipt, null);

  const full = validateCommitWire({ operation_id: "op", preview_receipt: "r" });
  assert.equal(full.replay_only, false);
});

test("replay: an id alone replays a committed operation across a lost receipt store", async () => {
  const h = harness();
  const first = await h.commit(h.body());
  assert.equal(first.ok, true);

  // The receipt store is ephemeral; the journal is not. Simulate the restart by
  // asking with the id and NOTHING else.
  const restarted = h.restart();
  const replayed = await restarted.commit({ operation_id: "op-1" });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.prompt_shown, false, "prompt +0");
  assert.equal(replayed.authority_written, false, "write +0");
  assert.equal(restarted.prompts.length, 0);
  assert.equal(restarted.writes.length, 0);
});

test("replay: an id alone can NEVER start a new mutation", async () => {
  const h = harness();
  const result = await h.commit({ operation_id: "never-seen" });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "no_committed_operation");
  assert.equal(result.prompt_shown, false);
  assert.equal(h.prompts.length, 0, "and it costs her no dialog");
  assert.equal(h.writes.length, 0);
});

test("replay: an UNAUTHENTICATED id-only request returns no state at all", async () => {
  const h = harness();
  await h.commit(h.body());
  h.state.session = null;
  const result = await h.commit({ operation_id: "op-1" });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "read_session_invalid");
  assert.equal(result.result, undefined, "operation_id is not a bearer credential");
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

test("replay: the journal records aborts rather than silently forgetting them", async () => {
  const h = harness({ outcome: "cancelled" });
  await h.commit(h.body());
  const entry = h.storage.read().find((e) => e.operation_id === "op-1");
  assert.equal(entry.phase, "aborted");
  assert.equal(entry.error, "cancelled");
  assert.equal(h.deps.operations.completed("op-1"), null, "an aborted operation is not replayable");

  // And DEFINITIVELY so. A refused verification must not leave the id reusable,
  // or anything that kept it could ask her again.
  const retry = await h.commit(h.body());
  assert.equal(retry.ok, false);
  assert.equal(retry.failure, "operation_aborted");
  assert.equal(retry.prompt_shown, false, "a spent id must not cost her a second dialog");
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


// ---------------------------------------------------------------------------
// Operation ownership — the parts 0-8 review, P0-3
// ---------------------------------------------------------------------------

test("ownership: two concurrent requests with one id produce ONE prompt", async () => {
  // The defect this replaces: both could pass an in-process `completed()` check
  // and both could begin, so she could be asked twice for one intention.
  const h = harness();
  const [a, b] = await Promise.all([h.commit(h.body()), h.commit(h.body())]);
  assert.equal(h.prompts.length, 1, "one intention, one dialog");
  assert.equal(h.writes.length, 1, "and one write");

  const winners = [a, b].filter((r) => r.ok && !r.replayed);
  const losers = [a, b].filter((r) => !r.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].failure, "operation_in_progress");
  assert.equal(losers[0].prompt_shown, false);
});

test("ownership: the same id with a DIFFERENT receipt is a collision, not a replay", async () => {
  const h = harness();
  await h.commit(h.body());
  assert.equal(h.prompts.length, 1);

  // A second prepared review, same operation id. Without a receipt binding this
  // is indistinguishable from a legitimate retry — and would have replayed the
  // FIRST receipt's result for a change she never reviewed.
  const other = h.issue({ statement: "a different bounded task" });
  const result = await h.commit(h.body({ preview_receipt: other.receipt_id }));
  assert.equal(result.ok, false);
  assert.equal(result.failure, "idempotency_collision");
  assert.equal(result.prompt_shown, false);
  assert.equal(h.writes.length, 1, "and nothing was written for it");
});

test("ownership: a committed id retried with its own receipt replays without prompting", async () => {
  const h = harness();
  const first = await h.commit(h.body());
  assert.equal(first.ok, true);

  const again = await h.commit(h.body());
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(h.prompts.length, 1, "prompt delta 0");
  assert.equal(h.writes.length, 1, "write delta 0");
});

test("ownership: a claim survives a restart, and cannot resume", async () => {
  // The claim is durable, so a restart SEES it. It must also refuse to continue
  // it: owner presence is a one-shot object in memory and dies with the
  // process, so a resumable claim would be a claim with no presence behind it.
  const h = harness();
  h.state.stallAfterClaim = true;
  await h.commit(h.body()).catch(() => {});

  const before = h.storage.read().find((e) => e.operation_id === "op-1");
  assert.ok(before, "the claim is on disk before any prompt completes");

  const restarted = h.restart();
  const entry = restarted.storage.read().find((e) => e.operation_id === "op-1");
  assert.equal(entry.phase, "aborted", "a pre-prompt claim cannot survive its process");
  assert.match(entry.error, /restart/);
});

// ---------------------------------------------------------------------------
// Durable commit — the parts 0-8 review, P0-4
// ---------------------------------------------------------------------------

test("durable: a failing authority write is NOT recorded as a completed success", async () => {
  // It used to be: applyAuthority's return value was passed straight to
  // complete(), so {ok:false} became a committed operation.
  const h = harness({ applyResult: { ok: false, outcome: "store_refused", reason: "the store said no" } });
  const result = await h.commit(h.body());
  assert.equal(result.ok, false);
  assert.equal(result.failure, "store_refused");
  assert.equal(h.deps.operations.completed("op-1"), null, "and it is not replayable as a success");
  const entry = h.storage.read().find((e) => e.operation_id === "op-1");
  assert.equal(entry.phase, "aborted");
});

test("durable: the receipt is consumed only after the durable commit", async () => {
  const h = harness({ applyResult: { ok: false, outcome: "store_refused", reason: "no" } });
  await h.commit(h.body());
  // Still present, so she can re-present it rather than losing the review to a
  // failure that wrote nothing.
  const found = h.deps.receipts.verify(h.receipt.receipt_id, {}, { readSessionId: SESSION });
  assert.equal(found.ok, true, "a failed commit must not consume the review");
});

// ---------------------------------------------------------------------------
// Stale authority — absence is a revision
// ---------------------------------------------------------------------------

test("stale: a competing FIRST grant blocks an initial grant prepared at empty", async () => {
  // Both staleness checks used to be conditional on a non-null base revision,
  // so an initial grant compared nothing at all and two first grants could land.
  const h = harness({ revision: null, baseRevision: null });
  h.state.duringPrompt = () => { h.state.revision = 1; };
  const result = await h.commit(h.body());
  assert.equal(result.ok, false);
  assert.equal(result.failure, "stale_authority_revision");
  assert.equal(result.authority_written, false);
  assert.equal(h.writes.length, 0);
});

test("stale: the final CAS runs inside the transaction, not only before it", async () => {
  // Everything before the dialog is a read. Only the write is atomic with the
  // state, so the last comparison has to live there.
  const h = harness();
  h.state.duringCommit = () => { h.state.revision += 1; };
  const result = await h.commit(h.body());
  assert.equal(result.ok, false);
  assert.equal(result.failure, "stale_authority_revision");
  assert.equal(h.writes.length, 0, "the CAS refused before applyAuthority ran");
});
