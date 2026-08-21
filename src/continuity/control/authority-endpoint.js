// The PRIVILEGED side of the authority boundary — PR B governance review, P0-1.
//
// This module never reaches the browser bundle. It runs in the trusted process
// (local privileged host / worker / server), and it authenticates the CURRENT
// caller from its own environment rather than from anything in the request.
//
//   browser React
//       ↓ requests an authority operation
//   THIS boundary
//       ↓ authenticates the caller independently
//   durable authority transaction
//
// The request body is treated as an expression of intent and nothing else.

import { createAuthorityStore, createOwnerBoundary, shadowReauditRequest } from "./authority-store.js";
import { sanitizeClientRequest } from "./authority-request.js";
import { composeEnvelope, renderPreview } from "./authority-draft.js";
import { materialEvents } from "./authority-events.js";
import { createReceiptStore, receiptPreview } from "./authority-receipt.js";

/** The small, explicit failure taxonomy (§17). No stack traces cross this line. */
export const FAILURES = [
  "not_authenticated", "not_owner", "stale_preview", "stale_revision",
  "invalid_scope", "not_admissible", "transaction_failed", "already_completed",
  // Receipt failures (V6.1.6 §3). Distinct cases, because each is a different
  // attack and lumping them together loses the reason.
  "no_receipt", "expired_receipt", "receipt_domain_mismatch", "stale_receipt_revision",
  "receipt_action_mismatch", "receipt_lineage_mismatch", "receipt_scope_mismatch",
  "receipt_kind_mismatch",
];

/**
 * EVERY owner-facing operation authenticates, not just the writes (§2).
 *
 * The authority context carries the current authority, the blocker, the
 * owner-authored suggestions, drafts and private scope metadata. Authenticating
 * only `authorize` would leave all of that readable by anything that could
 * reach the endpoint. The V6 control plane reads authority internally and does
 * not need this browser-facing API at all.
 */
export const AUTHENTICATED_OPERATIONS = ["context", "prepare", "authorize", "current", "blocker", "catalogue", "suggestions", "draft"];

/**
 * Build the privileged handler.
 *
 * `authenticateCaller` is supplied by the host process — a cookie/session/IPC
 * check the page cannot participate in. It receives NOTHING from the request,
 * which is what makes it un-spoofable rather than merely un-spoofed.
 */
export function createAuthorityEndpoint({
  authenticateCaller, exceptions, now, storage = null, shadowAudit = null,
  readContext = null, faultInjector = null, receipts = null, requireReceipt = false,
}) {
  if (typeof authenticateCaller !== "function") {
    throw new Error("the authority endpoint requires a host-provided caller authenticator");
  }

  const boundary = createOwnerBoundary({ authenticate: () => authenticateCaller() });
  // faultInjector is a construction-time TEST capability. Nothing in a request
  // can reach it.
  const store = createAuthorityStore({ boundary, exceptions, now, storage, faultInjector });
  // Receipts live in the privileged process and never cross the boundary as
  // anything but an opaque id.
  const receiptStore = receipts ?? createReceiptStore({ now });

  const fail = (failure, reason, extra = {}) => ({ ok: false, failure, reason, ...extra });

  function authorize(rawBody) {
    // Identity-shaped fields are REMOVED, not merely rejected: a rejected spoof
    // still reached the decision, and stripped fields cannot be read by code
    // written later that forgets why the check was there.
    const { request, stripped_identity_fields } = sanitizeClientRequest(rawBody);

    const principal = authenticateCaller();
    if (!principal) return fail("not_authenticated", "no authenticated caller", { stripped_identity_fields });
    if (principal.role !== "owner") return fail("not_owner", "the caller is not the owner", { stripped_identity_fields });

    // DURABLE IDEMPOTENCY COMES FIRST (A.1 P0-2).
    //
    // A committed operation replays before any receipt is considered. The
    // previous order consumed the receipt and then committed, so a lost
    // response plus a retry produced `no_receipt` for work that had ALREADY
    // succeeded — a short-lived preview receipt must never be able to undo the
    // durable idempotency V6.1.5 established. A host restart may destroy every
    // receipt; that is fine. A new review needs a new receipt. A retry of an
    // already-committed operation does not.
    const alreadyCommitted = store.completedOperation(request.operation_id);
    if (alreadyCommitted) {
      const replayed = store.commit({ operation_id: request.operation_id });
      return {
        ok: true, replayed: true, goal_id: replayed.goal_id, revision: replayed.revision,
        outcome: replayed.outcome, exception_resolved: replayed.exception_resolved,
        shadow_audit: null, shadow_audit_failed: false, stripped_identity_fields,
      };
    }

    // §3 + A.1 P0-1: the receipt binds the ENTIRE authoritative mutation — the
    // action, the lineage, the base revision, the resulting scope and the
    // policy. The browser identifies the prepared authorization; it does not
    // reconstruct its semantics here. Anything it also sent is checked for
    // exact equality and REFUSED on mismatch, which exposes a stale or
    // malicious client rather than silently tolerating disagreement.
    let policy = { draft: request.draft, policy_identity: request.policy_identity, source_exception_id: request.source_exception_id };
    let action = request.authorization_action;
    let goalId = request.goal_id;
    let expectedRevision = request.expected_authority_revision;
    let scopeRefs = request.scope_refs;
    let receiptId = null;

    if (requireReceipt) {
      const verified = receiptStore.verify(request.preview_receipt, {
        action: request.authorization_action,
        goalId: request.goal_id,
        sourceExceptionId: request.source_exception_id,
        baseRevision: request.expected_authority_revision,
        scopeRefs: request.scope_refs,
      });
      if (!verified.ok) return fail(verified.failure, verified.reason, { stripped_identity_fields });
      const bound = verified.receipt;
      // EVERY authoritative field now comes from the receipt.
      action = bound.action;
      goalId = bound.goal_id;
      expectedRevision = bound.base_authority_revision;
      scopeRefs = bound.resulting_scope_refs ?? undefined;
      policy = {
        draft: bound.normalized_policy,
        policy_identity: bound.policy_identity,
        source_exception_id: bound.source_exception_id,
      };
      receiptId = request.preview_receipt;
    }

    const result = store.commit({
      operation_id: request.operation_id,
      action,
      draft: policy.draft,
      policy_identity: policy.policy_identity,
      source_exception_id: policy.source_exception_id,
      goal_id: goalId,
      expected_revision: expectedRevision,
      scope_refs: scopeRefs,
    });

    if (!result.ok) {
      const failure = {
        stale_preview: "stale_preview",
        stale_revision: "stale_revision",
        not_a_narrowing: "invalid_scope",
        not_admissible: "not_admissible",
        invalid_draft: "not_admissible",
        resolution_failed: "transaction_failed",
        crashed: "transaction_failed",
      }[result.outcome] || "transaction_failed";
      return fail(failure, result.reason, { stripped_identity_fields });
    }

    // Single use, consumed only once the transaction is durable. Consuming
    // earlier is what broke idempotent replay.
    if (receiptId) receiptStore.consume(receiptId);

    // §16: attempted, never load-bearing for the ruling. "Authority was
    // granted" and "readiness could not be evaluated" are different facts.
    let audit = null;
    if (shadowAudit && result.record) {
      try { audit = shadowAudit(shadowReauditRequest(result.record)); }
      catch (error) { audit = { ok: false, reason: String(error.message || error) }; }
    }

    return {
      ok: true,
      replayed: result.replayed,
      goal_id: result.goal_id,
      revision: result.revision,
      outcome: result.outcome,
      exception_resolved: result.exception_resolved,
      shadow_audit: audit,
      shadow_audit_failed: Boolean(audit && audit.ok === false),
      stripped_identity_fields,
    };
  }

  /**
   * Prepare a review (§3).
   *
   * The host normalizes, validates, computes the identity, binds the domain and
   * base revision, and returns BOTH the receipt and the exact preview to
   * render. The browser has nothing else to draw from, so the displayed policy
   * and the bound policy are one object by construction.
   */
  function prepare(rawBody) {
    const { request } = sanitizeClientRequest(rawBody);
    const preparingAmendment = request.authorization_action === "narrow_authority"
      || request.authorization_action === "revoke_authority";
    if (!request.draft && !preparingAmendment) return fail("transaction_failed", "no draft supplied");

    const domain = readContext?.domain?.() ?? readContext?.blocker?.()?.id ?? null;
    const action = request.authorization_action ?? "authorize_goal";
    const amending = action === "narrow_authority" || action === "revoke_authority";

    // The host determines WHICH authority an amendment concerns, from the
    // authority domain it already holds. The browser may say "narrow the
    // authority I am viewing"; it does not get to choose the lineage. Browser
    // = intent, host = authoritative context, consistently.
    const lineage = amending ? store.currentForDomain(domain) : null;
    if (amending && !lineage) return fail("transaction_failed", "no current authority to amend");

    const receipt = receiptStore.issue({
      draft: request.draft,
      action,
      authorityDomain: domain,
      // Bound HOST-side. A browser cannot point a review at another domain.
      sourceExceptionId: amending ? null : domain,
      goalId: amending ? lineage.goal.goal_id : null,
      baseRevision: amending ? lineage.revision : null,
      // The resulting scope is part of what she reviewed, so it is bound too.
      resultingScopeRefs: amending
        ? (action === "revoke_authority" ? [] : (request.scope_refs ?? []))
        : null,
    });
    const envelope = composeEnvelope(receipt.normalized_policy?.allowed_capabilities ?? []);
    return {
      ok: true,
      preview_receipt: receipt.receipt_id,
      expires_at: receipt.expires_at,
      // What the owner is told the mutation IS, bound to the same receipt.
      action: receipt.action,
      goal_id: receipt.goal_id,
      base_authority_revision: receipt.base_authority_revision,
      resulting_scope_refs: receipt.resulting_scope_refs,
      preview: receipt.normalized_policy ? receiptPreview(receipt, envelope, renderPreview) : null,
    };
  }

  const handlers = {
    authorize,
    prepare,
    /**
     * ONE atomic contextual read (PR B third review, P0-1).
     *
     * The browser is never taught goal ids. It asks for the context of an
     * authority domain and receives everything the surface needs, including
     * authority granted in an earlier session — which the previous
     * `readCurrentAuthority()` with no argument silently returned null for,
     * so a refresh made durable authority vanish from the owner-facing route.
     */
    context: () => {
      const blocker = readContext?.blocker?.() ?? null;
      // Found by originating exception, so it keeps resolving AFTER the
      // blocker itself has been resolved by the grant.
      const domain = readContext?.domain?.() ?? blocker?.id ?? null;
      const record = domain ? store.currentForDomain(domain) : null;
      return {
        ok: true,
        blocker,
        record,
        revision: record?.revision ?? null,
        state: record?.state ?? null,
        catalogue: readContext?.catalogue?.() ?? [],
        suggestions: readContext?.suggestions?.() ?? [],
        draft: readContext?.draft?.() ?? null,
      };
    },
    current: ({ goal_id }) => {
      const record = store.current(goal_id);
      return record
        ? { ok: true, revision: record.revision, state: record.state, record, fixture: false }
        : { ok: true, revision: null, state: null, record: null, fixture: false };
    },
    blocker: () => ({ ok: true, blocker: readContext?.blocker?.() ?? null }),
    catalogue: () => ({ ok: true, catalogue: readContext?.catalogue?.() ?? [] }),
    suggestions: () => ({ ok: true, suggestions: readContext?.suggestions?.() ?? [] }),
    draft: () => ({ ok: true, draft: readContext?.draft?.() ?? null }),
  };

  return {
    /**
     * Route one request. `op` comes from the path, the body from the client.
     *
     * Authentication happens HERE, for every owner-facing operation, so a read
     * cannot leak the current authority, the blocker, her drafts or her private
     * scope metadata to an unauthenticated caller.
     */
    handle(op, body) {
      const handler = handlers[op];
      if (!handler) return fail("transaction_failed", `unknown operation: ${op}`);
      if (AUTHENTICATED_OPERATIONS.includes(op)) {
        const principal = authenticateCaller();
        if (!principal || principal.role !== "owner") {
          // Report what was stripped even on an auth refusal, so a spoof
          // attempt is visible in the response rather than only in the denial.
          const { stripped_identity_fields } = sanitizeClientRequest(body ?? {});
          return principal
            ? fail("not_owner", "the caller is not the owner", { stripped_identity_fields })
            : fail("not_authenticated", "no authenticated caller", { stripped_identity_fields });
        }
      }
      return handler(body ?? {});
    },
    history: store.history,
    observableState: store.observableState,
    recoveredOnOpen: store.recoveredOnOpen,
    // The projection moved out of the store so the deployed authority set
    // does not carry the event schema. The endpoint still offers it.
    materialEvents: () => materialEvents(store),
  };
}

/**
 * Ordinary interaction is not authorization (§14).
 *
 * A list rather than an absence, so it can be counted end to end.
 */
export const NON_AUTHORITATIVE_ACTIONS = [
  "open_form", "type_goal", "select_scope", "tick_capability",
  "navigate_preview", "back", "not_now", "ctn",
];

export function isAuthorizationAction(action) {
  return ["authorize_goal", "authorize_bounded_task", "narrow_authority", "revoke_authority"].includes(action);
}
