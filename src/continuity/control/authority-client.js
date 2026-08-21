// The privileged authority boundary — spec V6.1.5 PR B §2, §3, §5, §7, §16,
// §17.
//
// The central invariant of this whole phase:
//
//   The browser may express WHAT the owner wants to authorize.
//   It may never assert THAT the caller is the owner.
//
// So React never constructs `authenticate()`. The UI calls
// `client.authorize(request)`; the client obtains identity from the session
// environment beneath it and hands a verified request to the PR A transaction.
// Passing `{ authenticate: () => "owner" }` down from a component would keep
// the PR A API shape while destroying the property it exists for.

import { createAuthorityStore, createOwnerBoundary, shadowReauditRequest } from "./authority-store.js";

/** The small, explicit failure taxonomy (§17). No stack traces cross this line. */
export const FAILURES = [
  "not_authenticated",
  "not_owner",
  "stale_preview",
  "stale_revision",
  "invalid_scope",
  "not_admissible",
  "transaction_failed",
  "already_completed",
];

/** Fields a browser may legitimately supply. Everything else is ignored. */
const CLIENT_FIELDS = [
  "draft_id", "policy_identity", "operation_id", "expected_authority_revision",
  "authorization_action", "draft", "goal_id", "scope_refs", "source_exception_id",
];

/** Fields a browser might supply that must NEVER influence authentication. */
export const SPOOFABLE_FIELDS = ["actor", "isOwner", "role", "authorizedBy", "owner", "principal", "credentials"];

/**
 * Strip anything identity-shaped from a browser payload (§2).
 *
 * Not "validate and reject" — REMOVE. A rejected spoof is still a spoof that
 * reached the decision; a stripped one cannot be read by code written later
 * that forgets why the check was there.
 */
export function sanitizeClientRequest(payload) {
  const clean = {};
  for (const key of CLIENT_FIELDS) {
    if (payload[key] !== undefined) clean[key] = payload[key];
  }
  const stripped = SPOOFABLE_FIELDS.filter((f) => payload[f] !== undefined);
  return { request: clean, stripped_identity_fields: stripped };
}

/**
 * Build the live authority client.
 *
 * `session` is the application boundary — it resolves the CURRENT caller and
 * is not something the UI can pass a value into. `shadowAudit` is attempted
 * after a committed transaction and its failure never rolls the ruling back
 * (§16): "authority was granted" and "we could not evaluate readiness" are
 * different facts, and pretending the first did not happen because the second
 * failed would be a lie about what the owner did.
 */
export function createAuthorityClient({ session, exceptions, now, shadowAudit = null }) {
  if (!session || typeof session.currentPrincipal !== "function") {
    throw new Error("a live authority client requires an application session boundary");
  }

  // The boundary reads identity from the session, NOT from anything a caller
  // supplies. This closure is the only authenticate() in the system.
  const boundary = createOwnerBoundary({
    authenticate: () => session.currentPrincipal(),
  });
  const store = createAuthorityStore({ boundary, exceptions, now });

  const fail = (code, reason) => ({ ok: false, failure: code, reason });

  function submit(payload) {
    const { request, stripped_identity_fields } = sanitizeClientRequest(payload);

    const principal = session.currentPrincipal();
    if (!principal) return { ...fail("not_authenticated", "no authenticated session"), stripped_identity_fields };
    if (principal.role !== "owner") return { ...fail("not_owner", "the session is not the owner"), stripped_identity_fields };

    const action = request.authorization_action;
    const result = store.commit({
      operation_id: request.operation_id,
      action,
      draft: request.draft,
      policy_identity: request.policy_identity,
      source_exception_id: request.source_exception_id,
      goal_id: request.goal_id,
      expected_revision: request.expected_authority_revision,
      scope_refs: request.scope_refs,
      // Deliberately absent: any credentials the browser supplied. The store's
      // boundary calls the session itself.
    });

    if (!result.ok) {
      const code = {
        stale_preview: "stale_preview",
        stale_revision: "stale_revision",
        not_a_narrowing: "invalid_scope",
        not_admissible: "not_admissible",
        invalid_draft: "not_admissible",
        resolution_failed: "transaction_failed",
      }[result.outcome] || "transaction_failed";
      return { ...fail(code, result.reason), stripped_identity_fields };
    }

    // §16: attempted, never load-bearing for the ruling.
    let audit = null;
    if (shadowAudit && result.record) {
      try {
        audit = shadowAudit(shadowReauditRequest(result.record));
      } catch (error) {
        audit = { ok: false, reason: String(error.message || error) };
      }
    }

    return {
      ok: true,
      replayed: result.replayed,
      goal_id: result.goal_id,
      revision: result.revision,
      exception_resolved: result.exception_resolved,
      // "Authority granted / readiness not evaluated" is a real and honest
      // state, and is not the same as "nothing was authorized".
      shadow_audit: audit,
      shadow_audit_failed: Boolean(audit && audit.ok === false),
      stripped_identity_fields,
    };
  }

  return {
    mode: "live",
    canWriteAuthority: true,

    /** The ONLY authority-creating entry point reachable from the UI. */
    authorize: submit,

    readCurrentAuthority(goalId) {
      // §8: the management screen reads PERSISTED state back, never the draft.
      const record = store.current(goalId);
      return record ? { revision: record.revision, state: record.state, record, fixture: false } : null;
    },

    history: store.history,
    materialEvents: store.materialEvents,
  };
}

/**
 * Ordinary interaction is not authorization (§14).
 *
 * Even on a verified owner session, these emit no authority transaction. This
 * is a list rather than an absence so it can be counted end to end.
 */
export const NON_AUTHORITATIVE_ACTIONS = [
  "open_form", "type_goal", "select_scope", "tick_capability",
  "navigate_preview", "back", "not_now", "ctn",
];

export function isAuthorizationAction(action) {
  return ["authorize_goal", "authorize_bounded_task", "narrow_authority", "revoke_authority"].includes(action);
}
