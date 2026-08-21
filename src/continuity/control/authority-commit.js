// The authority mutation transaction: parts 6, 7 and 8.
//
// This module owns the ORDER. Every step below exists because doing it later
// would let something through, and the sequence is the reviewable artifact:
//
//   authenticate the read session
//   durable replay lookup            (before any prompt)
//   retrieve the receipt
//   the receipt belongs to THIS session
//   validate domain / lineage / revision
//   derive the prompt ENTIRELY from the receipt
//   fresh Windows verification, via the host's ONE coordinator
//   re-read: session live, receipt live, revision current
//   consume the one-shot presence
//   commit the exact receipt-bound mutation
//   consume the receipt AFTER the durable commit
//
// The browser's part in this is two opaque strings. It supplies no policy, no
// scope, no action, no revision and no lineage, because anything it supplies is
// something it can be made to supply differently.

/**
 * Fields a browser must never send at commit.
 *
 * REJECTED, not ignored. Ignoring lets a stale or hostile client believe it is
 * steering the transaction while the host quietly does something else; the
 * mismatch then surfaces as a confusing success rather than a refusal. Refusing
 * says plainly that the commit wire is two identifiers and nothing more.
 */
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
 * Perform one authority mutation.
 *
 * Every dependency is injected so the ordering can be driven and inspected
 * without a live authority store — and so nothing here can reach a real device
 * or a real blocker by accident.
 */
export async function commitAuthority({
  body,
  authenticate,        // (…) -> { ok, context } from the request's cookie
  operations,          // durable operation ledger: { completed(id), begin(…), complete(…), abort(…) }
  receipts,            // the receipt store
  presence,            // { verifier, budget } from the host's ONE coordinator
  currentRevision,     // (receipt) -> the authority's current revision
  applyAuthority,      // (receipt) -> the durable authority write
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

  // 3. Durable replay, BEFORE any prompt. A lost response must not cost her a
  //    second dialog or a second write.
  const done = operations.completed(wire.operation_id);
  if (done) {
    return {
      ok: true, replayed: true, result: done.result,
      prompt_shown: false, authority_written: false,
    };
  }

  // 4. The receipt, and whether it belongs to THIS browser session.
  const found = receipts.verify(wire.preview_receipt, {}, { readSessionId: session });
  if (!found.ok) {
    return { ...found, prompt_shown: false, authority_written: false };
  }
  const receipt = found.receipt;

  // 5. Lineage and revision, from the receipt against the store.
  const revisionBefore = currentRevision(receipt);
  if (receipt.base_authority_revision !== null && receipt.base_authority_revision !== revisionBefore) {
    return {
      ok: false, failure: "stale_authority_revision",
      reason: "the authority changed since this review was prepared; review again",
      prompt_shown: false, authority_written: false,
    };
  }

  const allowed = presence.budget.mayPrompt();
  if (!allowed.ok) {
    return { ok: false, ...allowed, prompt_shown: false, authority_written: false };
  }

  operations.begin({ operation_id: wire.operation_id, receipt_id: receipt.receipt_id, at: now() });

  // 6. Fresh presence, described by the receipt.
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

  // 7. RE-READ. The dialog was open for a while, and three things could have
  //    moved underneath it. Each spends the presence and writes nothing: she
  //    reviewed a state that no longer exists, so she reviews again.
  const stillAuthenticated = authenticate();
  if (!stillAuthenticated.ok || stillAuthenticated.context.read_session_id !== session) {
    presence.verifier.authorizes(verification, `authority:${receipt.receipt_id}`);
    operations.abort(wire.operation_id, "read_session_lost");
    return {
      ok: false, failure: "read_session_lost",
      reason: "the owner-read session ended while the verification was open",
      prompt_shown: true, authority_written: false,
    };
  }
  const stillPrepared = receipts.verify(wire.preview_receipt, {}, { readSessionId: session });
  if (!stillPrepared.ok) {
    presence.verifier.authorizes(verification, `authority:${receipt.receipt_id}`);
    operations.abort(wire.operation_id, stillPrepared.failure);
    return { ...stillPrepared, prompt_shown: true, authority_written: false };
  }
  if (receipt.base_authority_revision !== null && currentRevision(receipt) !== revisionBefore) {
    presence.verifier.authorizes(verification, `authority:${receipt.receipt_id}`);
    operations.abort(wire.operation_id, "stale_authority_revision");
    return {
      ok: false, failure: "stale_authority_revision",
      reason: "the authority changed while the verification was open; review again",
      prompt_shown: true, authority_written: false,
    };
  }

  // 8. Consume the presence exactly once, then commit the receipt's mutation.
  const consumed = presence.verifier.authorizes(verification, `authority:${receipt.receipt_id}`);
  if (!consumed.ok) {
    operations.abort(wire.operation_id, "presence_not_valid");
    return { ok: false, failure: "presence_not_valid", reason: consumed.reason, prompt_shown: true, authority_written: false };
  }

  const result = await applyAuthority(receipt);
  operations.complete(wire.operation_id, result);

  // 9. Only now. A receipt consumed before the durable commit would leave a
  //    crash with no way to replay and no way to re-present.
  receipts.consume(receipt.receipt_id);

  return { ok: true, replayed: false, result, prompt_shown: true, authority_written: true };
}
