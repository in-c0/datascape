// Server-issued preview receipts — spec V6.1.6 §3.
//
// The consent boundary was:
//
//   the submitted draft hashes to the submitted hash
//
// Both of those values originate on the SAME side of the trust boundary, so
// they prove only that the browser is internally consistent with itself. A page
// that wanted to authorize something other than what it displayed could simply
// submit a matching pair.
//
// The boundary becomes:
//
//   the submitted authorization refers to the exact object the trusted
//   boundary previously prepared for this review
//
// The privileged host normalizes the draft, validates it, computes the policy
// identity, binds the originating exception and the base revision, and returns
// a receipt. Authorization then carries the RECEIPT — not a draft the browser
// could have replaced in between.
//
// Receipts are ephemeral on purpose. If the host restarts, the owner reviews
// again; that is safe, and much safer than persisting a stale draft as though
// it were authority.

import { randomBytes } from "node:crypto";
import { normalizeDraft, policyIdentityOf } from "./authority-draft.js";

export const DEFAULT_RECEIPT_TTL_MS = 10 * 60 * 1000;

/**
 * The receipt store lives in the privileged process and never leaves it.
 *
 * `now` is injected so expiry is testable without sleeping, like every other
 * clock in the control plane.
 */
export function createReceiptStore({ now, ttlMs = DEFAULT_RECEIPT_TTL_MS, randomToken = defaultToken }) {
  const receipts = new Map();

  const prune = (at) => {
    for (const [id, receipt] of receipts) {
      if (receipt.expires_at <= at) receipts.delete(id);
    }
  };

  return {
    /**
     * Prepare a review. Returns the receipt AND the exact preview the browser
     * must render, so what she reads is what the host bound.
     */
    issue({ draft, kind, sourceExceptionId, baseRevision = null }) {
      const at = now();
      prune(at);
      const normalized = normalizeDraft(draft);
      const receipt = {
        receipt_id: randomToken(),
        // Everything the commit must not re-derive from a browser payload.
        normalized_policy: normalized,
        policy_identity: policyIdentityOf(draft),
        authority_kind: kind,
        source_exception_id: sourceExceptionId ?? null,
        scope_refs: [...normalized.scope_refs],
        base_authority_revision: baseRevision,
        created_at: at,
        expires_at: at + ttlMs,
      };
      receipts.set(receipt.receipt_id, receipt);
      return receipt;
    },

    /**
     * Verify a receipt at commit time.
     *
     * Every refusal is a distinct, named case, because each is a different
     * attack and lumping them together loses the reason.
     */
    verify(receiptId, { sourceExceptionId = null, baseRevision = null } = {}) {
      const at = now();
      const receipt = receipts.get(receiptId);
      if (!receipt) return { ok: false, failure: "no_receipt", reason: "no prepared review matches this authorization" };
      if (receipt.expires_at <= at) {
        receipts.delete(receiptId);
        return { ok: false, failure: "expired_receipt", reason: "the prepared review expired; review again" };
      }
      // A receipt prepared for one authority domain may not authorize another.
      if (sourceExceptionId !== null && receipt.source_exception_id !== sourceExceptionId) {
        return { ok: false, failure: "receipt_domain_mismatch", reason: "this review was prepared for a different authority domain" };
      }
      // An amendment's receipt is bound to the revision it was prepared against.
      if (baseRevision !== null && receipt.base_authority_revision !== baseRevision) {
        return { ok: false, failure: "stale_receipt_revision", reason: "the authority changed since this review was prepared" };
      }
      return { ok: true, receipt };
    },

    /** Single-use: a consumed receipt cannot authorize a second time. */
    consume(receiptId) {
      const receipt = receipts.get(receiptId);
      receipts.delete(receiptId);
      return receipt ?? null;
    },

    /** For assertions only. Never exposed across the boundary. */
    size() {
      prune(now());
      return receipts.size;
    },
  };
}

function defaultToken() {
  // Unforgeable rather than merely unlikely to collide: a guessable receipt id
  // would let a page authorize a review it never performed.
  return `rcpt_${randomBytes(24).toString("hex")}`;
}

/**
 * What the browser is allowed to render.
 *
 * Returned alongside the receipt so the displayed preview and the bound policy
 * are the same object by construction — the browser has nothing else to draw
 * from.
 */
export function receiptPreview(receipt, envelope, renderPreview) {
  return {
    ...renderPreview(receipt.normalized_policy, envelope),
    receipt_id: receipt.receipt_id,
    expires_at: receipt.expires_at,
  };
}
