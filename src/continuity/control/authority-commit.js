// The authority mutation transaction: parts 6, 7 and 8.
//
// This module owns the ORDER. Every step below exists because doing it later
// would let something through, and the sequence is the reviewable artifact:
//
//   authenticate the read session
//   durable replay lookup            (before any prompt, no receipt needed)
//   retrieve the receipt
//   the receipt belongs to THIS session
//   validate domain / lineage / revision   (absence is revision 0)
//   DURABLE pre-prompt claim, bound to this receipt
//   derive the prompt ENTIRELY from the receipt
//   fresh Windows verification, via the host's ONE coordinator
//   re-read: session live, receipt live, revision current
//   consume the one-shot presence
//   commit inside ONE durable transaction, with a final revision CAS
//   consume the receipt AFTER the durable commit
//
// The browser's part in this is two opaque strings. It supplies no policy, no
// scope, no action, no revision and no lineage, because anything it supplies is
// something it can be made to supply differently.
//
// Two corrections from the parts 0-8 review are load-bearing here:
//
// - The pre-prompt claim is DURABLE and RECEIPT-BOUND. It used to be an
//   in-process Map, which meant two concurrent same-id requests could both
//   prompt, a same-id-different-receipt attempt was never noticed, and the
//   "durable replay" property vanished on restart.
// - The authority write happens INSIDE the durable transaction. It used to run
//   outside: an `applyAuthority()` that returned a failure was recorded as a
//   completed success, and a crash between the write and the completion marker
//   could prompt and write a second time.

/**
 * Fields a browser must never send at commit.
 *
 * REJECTED, not ignored. Ignoring lets a stale or hostile client believe it is
 * steering the transaction while the host quietly does something else; the
 * mismatch then surfaces as a confusing success rather than a refusal. Refusing
 * says plainly that the commit wire is two identifiers and nothing more.
 */
import { expectedRevision, receiptBinding, revisionOf } from "./authority-operation.js";

export const FORBIDDEN_COMMIT_FIELDS = [
  "authorization_action", "action", "draft", "policy", "normalized_policy", "policy_identity",
  "scope_refs", "resulting_scope_refs", "goal_id", "expected_authority_revision",
  "base_authority_revision", "source_exception_id", "authority_domain", "authority_kind",
  "read_session_id", "receipt", "principal",
];

/** The only two things a commit may carry. */
export const COMMIT_FIELDS = ["operation_id", "preview_receipt"];

export function validateCommitWire(body = {}) {
  const present = Object.keys(body ?? {});
  const forbidden = present.filter((key) => FORBIDDEN_COMMIT_FIELDS.includes(key));
  if (forbidden.length) {
    return {
      ok: false, failure: "browser_authoritative_field",
      reason: `a commit carries an operation id and a receipt, nothing else. Refused: ${forbidden.join(", ")}`,
      fields: forbidden,
    };
  }
  const unknown = present.filter((key) => !COMMIT_FIELDS.includes(key));
  if (unknown.length) {
    return { ok: false, failure: "unknown_commit_field", reason: `unexpected field(s): ${unknown.join(", ")}` };
  }
  if (!body.operation_id || typeof body.operation_id !== "string") {
    return { ok: false, failure: "invalid_commit", reason: "an authority commit needs a stable operation id" };
  }
  if (!body.preview_receipt || typeof body.preview_receipt !== "string") {
    return { ok: false, failure: "invalid_commit", reason: "an authority commit needs the receipt it was prepared with" };
  }
  return { ok: true, operation_id: body.operation_id, preview_receipt: body.preview_receipt };
}

/**
 * The OS prompt, derived ENTIRELY from the prepared receipt.
 *
 * Never from the request. What Windows describes and what the host commits have
 * to be the same object, and the receipt is the only thing that is.
 */
export function promptForReceipt(receipt) {
  const scope = (receipt.resulting_scope_refs ?? receipt.scope_refs ?? []).join(", ");
  const lines = {
    authorize_goal: "Authorize DataScape autonomous work",
    authorize_bounded_task: "Authorize one bounded DataScape task",
    narrow_authority: "Narrow autonomous work under this DataScape goal",
    revoke_authority: "Stop autonomous work under this DataScape goal",
  };
  return [
    lines[receipt.action] ?? `Authorize a DataScape owner action (${receipt.action})`,
    scope ? `Scope: ${scope}` : null,
    receipt.normalized_policy?.max_cost !== undefined
      ? `Paid usage: $${receipt.normalized_policy.max_cost}` : null,
  ].filter(Boolean).join("\n");
}

/**
 * Prepare a review, in the production HTTP path.
 *
 * REQUIRES a live read session and binds it into the receipt. The receipt store
 * tolerates an unbound receipt so the generic substrate stays usable by
 * non-browser tests — but the browser path must not rely on every future caller
 * remembering an optional argument, so issuing an unbound receipt is impossible
 * from here rather than merely discouraged.
 */
export function prepareAuthority({ authenticate, receipts, issue }) {
  const auth = authenticate();
  if (!auth.ok) {
    return { ok: false, failure: auth.failure, reason: auth.reason };
  }
  const session = auth.context.read_session_id;
  if (!session) {
    return { ok: false, failure: "no_read_session", reason: "owner controls are locked" };
  }

  const receipt = receipts.issue({ ...issue, readSessionId: session });
  if (receipt.read_session_id !== session) {
    // Defence in depth: a store that silently dropped the binding would give
    // back a portable receipt, and the whole of part 5 would be decoration.
    return { ok: false, failure: "receipt_not_bound", reason: "the prepared review was not bound to this session" };
  }
  return { ok: true, receipt };
}

/**
 * Perform one authority mutation.
 *
 * Every dependency is injected so the ordering can be driven and inspected
 * without a live authority store — and so nothing here can reach a real device
 * or a real blocker by accident.
 */
export async function commitAuthority({
  body,
  authenticate,        // (…) -> { ok, context } from the request's cookie
  operations,          // the DURABLE journal port: { completed, claim, commit, abort }
  receipts,            // the receipt store
  presence,            // { verifier, budget } from the host's ONE coordinator
  currentRevision,     // (receipt) -> the authority's current revision, or null for none
  now,
}) {
  // 1. The wire, before anything else. A malformed or over-specified commit
  //    must not reach a lookup, let alone a prompt.
  const wire = validateCommitWire(body);
  if (!wire.ok) return { ...wire, prompt_shown: false, authority_written: false };

  // 2. AUTHENTICATE FIRST — including for a replay. Returning a committed
  //    result to an unauthenticated caller would make operation_id a bearer
  //    credential for private authority state, which is the shape this whole
  //    design exists to avoid.
  const auth = authenticate();
  if (!auth.ok) {
    return { ok: false, failure: auth.failure, reason: auth.reason, prompt_shown: false, authority_written: false };
  }
  const session = auth.context.read_session_id;

  // 3. Durable replay, BEFORE any prompt and WITHOUT needing the receipt — a
  //    committed operation consumed its receipt, so requiring one here would
  //    turn every lost response into a fresh dialog.
  const done = operations.completed(wire.operation_id);
  if (done) {
    // A replay must be the SAME intention. The receipt object is gone — a
    // committed operation consumed it — so the comparison is against the
    // receipt id recorded with the claim. Without this, presenting a committed
    // id with a different prepared review replayed the first one's result for a
    // change she never approved.
    if (done.receipt_id && done.receipt_id !== wire.preview_receipt) {
      return {
        ok: false, failure: "idempotency_collision",
        reason: "this operation id was already used for a different prepared review",
        prompt_shown: false, authority_written: false,
      };
    }
    return { ok: true, replayed: true, result: done.result, prompt_shown: false, authority_written: false };
  }

  // 4. The receipt, and whether it belongs to THIS browser session.
  const found = receipts.verify(wire.preview_receipt, {}, { readSessionId: session });
  if (!found.ok) {
    return { ...found, prompt_shown: false, authority_written: false };
  }
  const receipt = found.receipt;

  // 5. Lineage and revision, UNCONDITIONALLY. Absence is revision 0, so a
  //    receipt prepared when no authority existed is checked by the same rule
  //    as every later revision — otherwise a competing first grant appearing
  //    before or during the dialog goes unnoticed and both write.
  const expected = expectedRevision(receipt);
  const revisionBefore = revisionOf(currentRevision(receipt));
  if (expected !== revisionBefore) {
    return {
      ok: false, failure: "stale_authority_revision",
      reason: "the authority changed since this review was prepared; review again",
      prompt_shown: false, authority_written: false,
    };
  }

  // 6. THE DURABLE CLAIM, bound to this receipt, before the prompt. Everything
  //    except a fresh claim means do not prompt.
  const binding = receiptBinding(receipt);
  const claim = operations.claim({
    operation_id: wire.operation_id, binding, receipt_id: receipt.receipt_id, at: now(),
  });
  if (!claim.ok) {
    return {
      ok: false, failure: claim.failure, reason: claim.reason,
      prompt_shown: false, authority_written: false,
    };
  }
  if (claim.state === "committed") {
    // Won by a concurrent request between step 3 and here.
    return { ok: true, replayed: true, result: claim.record, prompt_shown: false, authority_written: false };
  }

  const allowed = presence.budget.mayPrompt();
  if (!allowed.ok) {
    operations.abort(wire.operation_id, allowed.failure);
    return { ok: false, ...allowed, prompt_shown: false, authority_written: false };
  }

  // 7. Fresh presence, described by the receipt.
  const verification = await presence.verifier.verify({
    purpose: promptForReceipt(receipt),
    operationRef: `authority:${receipt.receipt_id}`,
  });
  presence.budget.recordOutcome(verification.outcome);
  if (verification.outcome !== "verified") {
    operations.abort(wire.operation_id, verification.outcome);
    return {
      ok: false, failure: verification.outcome, reason: verification.reason,
      prompt_shown: true, authority_written: false,
    };
  }

  // 8. RE-READ. The dialog was open for a while, and three things could have
  //    moved underneath it. Each spends the presence and writes nothing: she
  //    reviewed a state that no longer exists, so she reviews again.
  const spend = (outcome) => {
    presence.verifier.authorizes(verification, `authority:${receipt.receipt_id}`);
    operations.abort(wire.operation_id, outcome);
  };

  const stillAuthenticated = authenticate();
  if (!stillAuthenticated.ok || stillAuthenticated.context.read_session_id !== session) {
    spend("read_session_lost");
    return {
      ok: false, failure: "read_session_lost",
      reason: "the owner-read session ended while the verification was open",
      prompt_shown: true, authority_written: false,
    };
  }
  const stillPrepared = receipts.verify(wire.preview_receipt, {}, { readSessionId: session });
  if (!stillPrepared.ok) {
    spend(stillPrepared.failure);
    return { ...stillPrepared, prompt_shown: true, authority_written: false };
  }
  if (revisionOf(currentRevision(receipt)) !== revisionBefore) {
    spend("stale_authority_revision");
    return {
      ok: false, failure: "stale_authority_revision",
      reason: "the authority changed while the verification was open; review again",
      prompt_shown: true, authority_written: false,
    };
  }

  // 9. Consume the presence exactly once, then commit.
  const consumed = presence.verifier.authorizes(verification, `authority:${receipt.receipt_id}`);
  if (!consumed.ok) {
    operations.abort(wire.operation_id, "presence_not_valid");
    return { ok: false, failure: "presence_not_valid", reason: consumed.reason, prompt_shown: true, authority_written: false };
  }

  // 10. ONE durable transaction. The authority write, the exception resolution
  //     and the committed marker are the journal's business, including the
  //     final store-level revision CAS — checked once more inside, because
  //     everything up to here is a read and only this is atomic with the write.
  const committed = await operations.commit({
    operation_id: wire.operation_id,
    receipt,
    binding,
    expected_revision: expected,
  });
  if (!committed.ok) {
    return {
      ok: false, failure: committed.failure || "transaction_failed", reason: committed.reason,
      prompt_shown: true,
      // The journal decides this, not us: a crash mid-transaction may have left
      // a durable record that recovery will roll forward.
      authority_written: Boolean(committed.authority_written),
    };
  }

  // 11. Only now. A receipt consumed before the durable commit would leave a
  //     crash with no way to replay and no way to re-present.
  receipts.consume(receipt.receipt_id);

  return { ok: true, replayed: false, result: committed.result, prompt_shown: true, authority_written: true };
}
