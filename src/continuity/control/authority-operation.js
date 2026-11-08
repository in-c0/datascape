// The host-derived binding between an operation id and a prepared receipt.
//
// Why this exists at all: `operation_id` is chosen by the caller. On its own it
// answers "have I seen this before?" but not "is this the same thing?", and
// those differ in the case that matters — the same id presented with a
// different prepared review. Without a binding, that is indistinguishable from
// a legitimate retry, and a legitimate retry is exactly what we replay without
// prompting.
//
// So the durable claim carries a hash of the receipt's SEMANTIC content, and it
// is computed here, from the receipt the host issued. Nothing the browser sends
// contributes to it; the browser's entire contribution is two opaque strings.

import crypto from "node:crypto";

/**
 * The fields that make a prepared review "the same review".
 *
 * `receipt_id` is deliberately INCLUDED: two receipts prepared for identical
 * content are still two distinct authorisations, and collapsing them would let
 * one operation id commit a different receipt than the one it claimed.
 *
 * The read-session binding is included too — the same change prepared in a
 * different browser session is not the same transaction.
 */
export function receiptBinding(receipt) {
  if (!receipt || typeof receipt !== "object") {
    throw new Error("a receipt binding needs a prepared receipt");
  }
  const canonical = {
    receipt_id: receipt.receipt_id ?? null,
    read_session_id: receipt.read_session_id ?? null,
    action: receipt.action ?? null,
    authority_domain: receipt.authority_domain ?? null,
    goal_id: receipt.goal_id ?? null,
    source_exception_id: receipt.source_exception_id ?? null,
    base_authority_revision: receipt.base_authority_revision ?? null,
    scope_refs: [...(receipt.resulting_scope_refs ?? receipt.scope_refs ?? [])].sort(),
    policy_identity: receipt.policy_identity ?? null,
  };
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

/**
 * Absence is a REVISION, not a missing value.
 *
 * Both staleness checks used to be conditional on `base_authority_revision`
 * being non-null, so an initial grant — prepared when no authority existed —
 * compared nothing at all. Another grant could appear before or during the
 * Windows dialog and the commit would still write, producing two first grants
 * for one domain.
 *
 * Treating "no authority" as revision 0 makes the comparison unconditional, so
 * the initial-grant path is guarded by the same rule as every later revision.
 */
export const NO_AUTHORITY_REVISION = 0;

export function revisionOf(current) {
  if (current === null || current === undefined) return NO_AUTHORITY_REVISION;
  if (typeof current === "number") return current;
  return current.revision ?? NO_AUTHORITY_REVISION;
}

/** What the receipt expects the domain to be at. Never null. */
export function expectedRevision(receipt) {
  return receipt?.base_authority_revision ?? NO_AUTHORITY_REVISION;
}
