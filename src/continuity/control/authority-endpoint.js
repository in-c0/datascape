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

/** The small, explicit failure taxonomy (§17). No stack traces cross this line. */
export const FAILURES = [
  "not_authenticated", "not_owner", "stale_preview", "stale_revision",
  "invalid_scope", "not_admissible", "transaction_failed", "already_completed",
];

/**
 * Build the privileged handler.
 *
 * `authenticateCaller` is supplied by the host process — a cookie/session/IPC
 * check the page cannot participate in. It receives NOTHING from the request,
 * which is what makes it un-spoofable rather than merely un-spoofed.
 */
export function createAuthorityEndpoint({ authenticateCaller, exceptions, now, storage = null, shadowAudit = null, readContext = null, faultInjector = null }) {
  if (typeof authenticateCaller !== "function") {
    throw new Error("the authority endpoint requires a host-provided caller authenticator");
  }

  const boundary = createOwnerBoundary({ authenticate: () => authenticateCaller() });
  // faultInjector is a construction-time TEST capability. Nothing in a request
  // can reach it.
  const store = createAuthorityStore({ boundary, exceptions, now, storage, faultInjector });

  const fail = (failure, reason, extra = {}) => ({ ok: false, failure, reason, ...extra });

  function authorize(rawBody) {
    // Identity-shaped fields are REMOVED, not merely rejected: a rejected spoof
    // still reached the decision, and stripped fields cannot be read by code
    // written later that forgets why the check was there.
    const { request, stripped_identity_fields } = sanitizeClientRequest(rawBody);

    const principal = authenticateCaller();
    if (!principal) return fail("not_authenticated", "no authenticated caller", { stripped_identity_fields });
    if (principal.role !== "owner") return fail("not_owner", "the caller is not the owner", { stripped_identity_fields });

    const result = store.commit({
      operation_id: request.operation_id,
      action: request.authorization_action,
      draft: request.draft,
      policy_identity: request.policy_identity,
      source_exception_id: request.source_exception_id,
      goal_id: request.goal_id,
      expected_revision: request.expected_authority_revision,
      scope_refs: request.scope_refs,
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

  const handlers = {
    authorize,
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
    /** Route one request. `op` comes from the path, the body from the client. */
    handle(op, body) {
      const handler = handlers[op];
      if (!handler) return fail("transaction_failed", `unknown operation: ${op}`);
      return handler(body ?? {});
    },
    history: store.history,
    observableState: store.observableState,
    recoveredOnOpen: store.recoveredOnOpen,
    materialEvents: store.materialEvents,
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
