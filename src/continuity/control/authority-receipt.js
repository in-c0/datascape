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
    issue({ draft = null, action, sourceExceptionId = null, authorityDomain = null, goalId = null, baseRevision = null, resultingScopeRefs = null, readSessionId = null }) {
      const at = now();
      prune(at);
      const normalized = draft ? normalizeDraft(draft) : null;
      const receipt = {
        receipt_id: randomToken(),
        // THE ENTIRE AUTHORITATIVE MUTATION. Not just the policy: the action,
        // the lineage, the base revision and the resulting scope too.
        //
        // Binding only the revision was not enough. A review of "narrow
        // authority A at rev 1" left the commit still taking WHICH goal,
        // NARROW-OR-REVOKE, and WHAT RESULTING SCOPE from the browser — so a
        // receipt prepared for a narrowing could authorize a revoke merely
        // because both act on revision 1.
        //
        // The browser identifies the prepared authorization. It does not
        // reconstruct its semantics at commit time.
        action,
        // THE CANONICAL PREPARED DRAFT, retained verbatim.
        //
        // `normalized_policy` is not sufficient to rebuild the record:
        // `normalizeDraft()` deliberately drops `draft_id`, and the durable goal
        // and ruling identities are constructed from it (`goal:<draft_id>`,
        // `owner-ruling:<draft_id>:rev<n>`). Binding only the normalized policy
        // left the commit path passing `draft: null` to the record builder,
        // which refuses a missing draft — so an initial grant could not succeed
        // at all through the wired host.
        //
        // The draft stored here is the one the HOST authored at prepare time,
        // including a host-minted `draft_id`. The browser's own `draft_id` — the
        // React form sends the literal string "new" — must never become the
        // durable identity of an authorization.
        prepared_draft: draft ? JSON.parse(JSON.stringify(draft)) : null,
        normalized_policy: normalized,
        policy_identity: draft ? policyIdentityOf(draft) : null,
        authority_kind: normalized?.kind ?? null,
        authority_domain: authorityDomain ?? sourceExceptionId ?? null,
        source_exception_id: sourceExceptionId ?? null,
        goal_id: goalId,
        scope_refs: normalized ? [...normalized.scope_refs] : [],
        resulting_scope_refs: resultingScopeRefs ? [...resultingScopeRefs] : null,
        base_authority_revision: baseRevision,
        // WHICH BROWSER prepared this. Host-private: added from the
        // authenticated request context, never sent by the browser and never
        // returned to it.
        //
        // Without it a receipt is portable between owner-read sessions — she
        // reviews in one browser, the window rotates or expires, and the
        // prepared authorization is still presentable from whatever holds it
        // next. Re-review is cheap; a migrating receipt is not.
        read_session_id: readSessionId,
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
    verify(receiptId, claimed = {}, context = {}) {
      const at = now();
      const receipt = receipts.get(receiptId);
      if (!receipt) return { ok: false, failure: "no_receipt", reason: "no prepared review matches this authorization" };
      if (receipt.expires_at <= at) {
        receipts.delete(receiptId);
        return { ok: false, failure: "expired_receipt", reason: "the prepared review expired; review again" };
      }

      // The receipt belongs to the browser session that prepared it. Checked
      // before anything else the browser claims, because a receipt presented
      // from a different session is not a mismatched field — it is a different
      // review, and the same human unlocking twice does not make it the same
      // one.
      if (receipt.read_session_id !== null) {
        if (!context.readSessionId) {
          return { ok: false, failure: "receipt_session_missing", reason: "this review must be committed from the session that prepared it" };
        }
        if (context.readSessionId !== receipt.read_session_id) {
          return { ok: false, failure: "receipt_session_mismatch", reason: "this review was prepared in a different owner-read session" };
        }
      }

      // Anything the browser ALSO sent is checked for exact equality and
      // refused on mismatch rather than ignored. Ignoring would tolerate a
      // stale or malicious client silently; refusing exposes it.
      const mismatch = (field, claim, bound) =>
        claim !== undefined && claim !== null && String(claim) !== String(bound);

      if (mismatch("action", claimed.action, receipt.action)) {
        // The case that made this necessary: a narrow receipt used to revoke.
        return { ok: false, failure: "receipt_action_mismatch", reason: `this review was prepared for ${receipt.action}` };
      }
      if (mismatch("goal", claimed.goalId, receipt.goal_id)) {
        return { ok: false, failure: "receipt_lineage_mismatch", reason: "this review was prepared for a different authority" };
      }
      if (claimed.sourceExceptionId !== undefined && claimed.sourceExceptionId !== null
        && receipt.source_exception_id !== claimed.sourceExceptionId) {
        return { ok: false, failure: "receipt_domain_mismatch", reason: "this review was prepared for a different authority domain" };
      }
      if (claimed.baseRevision !== undefined && claimed.baseRevision !== null
        && receipt.base_authority_revision !== claimed.baseRevision) {
        return { ok: false, failure: "stale_receipt_revision", reason: "the authority changed since this review was prepared" };
      }
      if (claimed.scopeRefs) {
        const bound = [...(receipt.resulting_scope_refs ?? [])].sort().join("|");
        const sent = [...claimed.scopeRefs].sort().join("|");
        if (bound !== sent) {
          return { ok: false, failure: "receipt_scope_mismatch", reason: "the resulting scope differs from the reviewed one" };
        }
      }
      if (claimed.kind !== undefined && claimed.kind !== null && receipt.authority_kind !== claimed.kind) {
        return { ok: false, failure: "receipt_kind_mismatch", reason: "this review was prepared for a different authority kind" };
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
/**
 * Everything about a receipt the browser may see.
 *
 * `read_session_id` is deliberately absent: it is how the host recognises the
 * session, and a value the browser holds is a value the browser can be made to
 * replay from somewhere else.
 */
export function browserSafeReceipt(receipt) {
  const { read_session_id: _hidden, ...safe } = receipt;
  return safe;
}

export function receiptPreview(receipt, envelope, renderPreview) {
  return {
    ...renderPreview(receipt.normalized_policy, envelope),
    receipt_id: receipt.receipt_id,
    expires_at: receipt.expires_at,
  };
}
